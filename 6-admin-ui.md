# 6. Admin UI

## Relevant Source Files
* `src/BlazorShared/Authorization/Constants.cs`
* `src/Web/Pages/Admin/Index.cshtml.cs`
* `src/Web/Pages/Admin/EditCatalogItem.cshtml.cs`
* `src/ApplicationCore/Entities/OrderAggregate/Address.cs`
* `src/Web/ViewModels/Manage/RemoveLoginViewModel.cs`
* `tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs`
* `src/Web/Interfaces/ICatalogItemViewModelService.cs`

## Purpose and Scope
The Admin UI component provides a set of features for managing the application's administrative aspects. This includes user management, catalog item editing, and order tracking. The purpose of this module is to provide a centralized interface for administrators to perform various tasks related to the application.

The scope of this module encompasses the following key areas:

* User management: creating, updating, and deleting users
* Catalog item management: adding, editing, and removing catalog items
* Order tracking: viewing order status, processing orders, and managing order fulfillment

This module interacts with other components in the system to perform these tasks. For example, it relies on the Basket Service to manage user baskets and the Order Service to process orders.

## Components and State Management

### IndexModel
The `IndexModel` is responsible for rendering the admin dashboard. It uses the `_catalogItemViewModelService` to retrieve a list of catalog items and display them on the page.

```csharp
[src/Web/Pages/Admin/Index.cshtml.cs:9-13]
public class IndexModel : PageModel
{
    private readonly ICatalogItemViewModelService _catalogItemViewModelService;

    public IndexModel(ICatalogItemViewModelService catalogItemViewModelService)
    {
        _catalogItemViewModelService = catalogItemViewModelService;
    }

    public void OnGet()
    {
        // ...
    }
}
```

### EditCatalogItemModel
The `EditCatalogItemModel` is responsible for editing a specific catalog item. It uses the `_catalogItemViewModelService` to update the catalog item's properties and save the changes.

```csharp
[src/Web/Pages/Admin/EditCatalogItem.cshtml.cs:9-36]
public class EditCatalogItemModel : PageModel
{
    private readonly ICatalogItemViewModelService _catalogItemViewModelService;

    public EditCatalogItemModel(ICatalogItemViewModelService catalogItemViewModelService)
    {
        _catalogItemViewModelService = catalogItemViewModelService;
    }

    [BindProperty]
    public CatalogItemViewModel CatalogModel { get; set; } = new CatalogItemViewModel();

    public void OnGet(CatalogItemViewModel catalogModel)
    {
        // ...
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (ModelState.IsValid)
        {
            await _catalogItemViewModelService.UpdateCatalogItem(CatalogModel);
        }

        return RedirectToPage("/Admin/Index");
    }
}
```

### CatalogItemViewModel
The `CatalogItemViewModel` is a view model that represents a catalog item. It contains properties for the item's name, description, and other relevant details.

```csharp
[src/Web/ViewModels/CatalogItemViewModel.cs:5-10]
public class CatalogItemViewModel
{
    public string Name { get; set; }
    public string Description { get; set; }
    // ...
}
```

## Integration with Other Components

The Admin UI component interacts with other components in the system to perform various tasks. For example, it relies on the Basket Service to manage user baskets and the Order Service to process orders.

* The `IndexModel` uses the `_catalogItemViewModelService` to retrieve a list of catalog items and display them on the page.
* The `EditCatalogItemModel` uses the `_catalogItemViewModelService` to update the catalog item's properties and save the changes.
* The `BasketService` is used to manage user baskets and process orders.
* The `OrderService` is used to process orders and manage order fulfillment.

### Sequence Diagram
```
sequenceDiagram
    participant AdminUI as "Admin UI"
    participant BasketService as "Basket Service"
    participant OrderService as "Order Service"

    note "User requests a catalog item edit" as "Note 1"

    AdminUI->>BasketService: Get Catalog Item
    BasketService->>OrderService: Process Order

    note "Catalog item is updated" as "Note 2"

    AdminUI->>BasketService: Update Catalog Item
    BasketService->>OrderService: Save Changes
```

This sequence diagram shows the interactions between the Admin UI, Basket Service, and Order Service when a user requests to edit a catalog item. The Admin UI sends a request to the Basket Service to retrieve the catalog item's information, which is then processed by the Order Service. The updated catalog item is then saved by the Basket Service and processed by the Order Service.

## Cross-References
For more details on the Basket Service, see [Basket Service](2.1-basket-service.md). For more details on the Order Service, see [Order Service](2.2-order-service.md).

---

**Navigation:**
[← Table of Contents](index.md) | [← 5.2. API Services and Repositories](5.2-api-services-and-repositories.md) | [6.1. Components and State Management →](6.1-components-and-state-management.md)

**In this section:**
- [6.1. Components and State Management](6.1-components-and-state-management.md)
- [6.2. CRUD Operations and Data Access](6.2-crud-operations-and-data-access.md)